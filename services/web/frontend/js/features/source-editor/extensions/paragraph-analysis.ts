import { debugConsole } from "@/utils/debugging"
import { Line, StateEffect, StateField } from "@codemirror/state"
import { Decoration, EditorView, GutterMarker, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view"
import { LineTracker } from "./spelling/line-tracker"
import { waitForParser } from "./wait-for-parser"
import OError from '@overleaf/o-error'
import { NormalTextSpan, getNormalTextSpansFromLine } from "../utils/tree-query"

const _log = (...args: any) => {
    debugConsole.debug("[ParagraphAnalyzer]: ", ...args)
}

export const paragraphAnalysis = () => [
    paragraphAnalysisField,
    gutterMarkersField,
]

// Effects
const paragraphAnalyzed = StateEffect.define<{
    lineNumber: number,
    value: AnalysisData
}>()
const addMarkerEffect = StateEffect.define<{ from: number, to: number, marker: ParagraphAnalysisMarker }>()

// StateField
const paragraphAnalysisField = StateField.define<ParagraphAnalyzer | null>({
    create() {
        return new ParagraphAnalyzer()
    },
    update(analyzer, tr) {
        return analyzer
    },
    provide: f => [
        ViewPlugin.define(view => {
            return {
                destroy: () => {
                    view.state.field(f)?.destroy()
                },
            }
        }),
        EditorView.updateListener.of((update) => {
            if (update.state.facet(EditorView.editable)) {
                update.state.field(f)?.handleUpdate(update)
            }
        })]
})

const gutterMarkersField = StateField.define<Map<[number, number], LineWidget>>({
    create() {
        return new Map()
    },
    update(markers, transaction) {
        markers = new Map(markers)
        transaction.effects.forEach(effect => {
            if (effect.is(addMarkerEffect)) {
                const { from, to, marker } = effect.value
                const existing = markers.get([from, to]) || new LineWidget([])
                existing.markers.push(marker)
                markers.set([from, to], existing)
            }
        })
        return markers
    },
    provide: field => EditorView.decorations.from(field, value => {
        const decorations = []
        for (const [[from, to], marker] of value) {
            // decorations.push(Decoration.mark({
            //     class: 'paragraph-analysis-gutter',
            //     side: -1,
            //     widget: marker
            // }).range(from, to))
            decorations.push(Decoration.widget({
                widget: marker,
                side: 1
            }).range(to))
        }
        decorations.sort((a, b) => {
            return a.from - b.from;
        });
        return Decoration.set(decorations)
    })
})

// Types and Interfaces

type ParagraphAnalysisResult = {
    index: number
    analysisData: AnalysisData
    metadata: {
        wordCount: number
        sentenceCount: number
        time: Date
    }
}

type AnalysisData = {
    sentimentScore?: number
    readibilityScore?: number
    topics?: string[]
    summary?: string
    suggestions?: string[]
    references?: string[]
    tags?: string[]
}

// Paragraph Analyzer

class ParagraphAnalyzer {
    private abortController?: AbortController | null = null
    private timeout: number | null = null
    private firstCheck = true
    private lineTracker: LineTracker | null = null
    private waitingForParser = false

    destroy() {
        _log("destroy")
        this._clearPendingParagraphAnalysis()
    }

    _abortRequest() {
        if (this.abortController) {
            _log("aborting request")
            this.abortController.abort()
            this.abortController = null
        }
    }

    _clearPendingParagraphAnalysis() {
        if (this.timeout) {
            window.clearTimeout(this.timeout)
            this.timeout = null
        }
        this._abortRequest()
    }

    handleUpdate(update: ViewUpdate) {
        if (!this.lineTracker) {
            this.lineTracker = new LineTracker(update.state.doc)
        }
        if (update.docChanged) {
            this.lineTracker.applyUpdate(update)
            this.scheduleParagraphAnalysis(update.view)
        } else if (update.viewportChanged) {
            this.scheduleParagraphAnalysis(update.view)
        }
    }

    scheduleParagraphAnalysis(view: EditorView) {
        this._clearPendingParagraphAnalysis()
        this.timeout = window.setTimeout(() => {
            if (this.waitingForParser) {
                return
            }
            this.waitingForParser = true
            waitForParser(view, view => view.viewport.to).then(() => {
                this.waitingForParser = false
                this._performParagraphAnalysis(view)
            })
            this.timeout = null
        }, 1000)
    }

    _performParagraphAnalysis(view: EditorView) {
        if (!this.lineTracker) {
            this.lineTracker = new LineTracker(view.state.doc)
        }
        let paragraphsToCheck: Paragraph[] = []
        for (const line of viewportLinesToCheck(this.lineTracker, this.firstCheck, view)) {
            paragraphsToCheck = paragraphsToCheck.concat(getParagraphsFromLine(view, line))
        }
        if (paragraphsToCheck.length === 0) {
            return
        }
        _log('- paragraphs to check', paragraphsToCheck.map(p => p.text))
        const processResult = (analysisResults: ParagraphAnalysisResult[]) => {
            paragraphsToCheck.forEach(p => this.lineTracker?.clearLine(p.lineNumber))
            if (this.firstCheck) {
                this.firstCheck = false
            }
            const paragraphAnalysisResult = buildParagraphAnalysisResult(paragraphsToCheck, analysisResults)
            _log('- result', paragraphAnalysisResult)
            window.setTimeout(() => {
                view.dispatch({
                    effects: compileEffects(paragraphAnalysisResult),
                })
            }, 0)
        }
        this._abortRequest()
        this.abortController = new AbortController()
        paragraphAnalysisRequest(paragraphsToCheck, this.abortController.signal).then(result => {
            this.abortController = null
            _log('>> response', result)
            processResult(result.analysisResults)
        })
            .catch(error => {
                this.abortController = null
                _log('>> error in paragraph analysis request', error)
            })
    }
}

// Paragraph

export class Paragraph {
    public from: number
    public to: number
    public text: string
    public lineNumber: number
    public suggestions?: string[]

    constructor(options: {
        from: number
        to: number
        text: string
        lineNumber: number
    }) {
        const { from, to, text, lineNumber } = options
        if (text == null || from == null || to == null || lineNumber == null) {
            throw new OError("ParagraphAnalysis: invalid paragraph options").withInfo({ options })
        }
        this.from = options.from
        this.to = options.to
        this.text = options.text
        this.lineNumber = options.lineNumber
    }
}

// Paragraph Analysis Request

async function paragraphAnalysisRequest(
    paragraphs: Paragraph[],
    signal: AbortSignal
) {
    const textParagraphs = paragraphs.map(p => p.text)
    const response = await fetch('http://localhost:5000/paragraph/analyze', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            paragraphs: textParagraphs,
        }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`Failed to analyze paragraphs: ${response.statusText}`)
    }
    return response.json()
}

// Gutter related DOM helper

class ParagraphAnalysisMarker extends GutterMarker {
    constructor(public paragraph: Paragraph) {
        super()
    }

    toDOM(view: EditorView) {
        const marker = document.createElement("span")
        marker.className = 'paragraph-analysis-marker'
        marker.textContent = "📝"
        marker.style.cursor = "pointer"
        // marker.title should be the list of suggestions
        marker.title = this.paragraph.suggestions?.join("\n") || ""
        marker.onclick = () => this.showAnalysis(view, this.paragraph);
        return marker
    }

    showAnalysis(view: EditorView, paragraph: Paragraph) {
        const suggestions = paragraph.suggestions || []
        const content = document.createElement("div")
        suggestions.forEach(suggestion => {
            const suggestionElement = document.createElement("div")
            suggestionElement.textContent = suggestion
            content.appendChild(suggestionElement)
        })
    }
}

class LineWidget extends WidgetType {
    constructor(public markers: GutterMarker[]) {
        super()
    }
    toDOM(view: EditorView) {
        const container = document.createElement("span")
        this.markers.forEach(marker => {
            container.appendChild(marker.toDOM(view))
        })
        return container
    }
}

// Helper

const buildParagraphAnalysisResult = (
    paragraphsToCheck: Paragraph[],
    analysisResults: ParagraphAnalysisResult[]
) => {
    const result: [Paragraph, ParagraphAnalysisResult][] = []
    for (let analysisResult of analysisResults) {
        const paragraph = paragraphsToCheck[analysisResult.index]
        paragraph.suggestions = analysisResult.analysisData.suggestions
        result.push([paragraph, analysisResult])
    }
    return result
}

const getParagraphsFromLine = (
    view: EditorView,
    line: Line
): Paragraph[] => {
    const lineNumber = line.number
    const normalTextSpans: Array<NormalTextSpan> = getNormalTextSpansFromLine(view, line)
    const paragraphs: Paragraph[] = []
    normalTextSpans.forEach(span => {
        paragraphs.push(new Paragraph({
            from: span.from,
            to: span.to,
            text: span.text,
            lineNumber
        }))
    })
    return paragraphs
}

const compileEffects = (analysisResults: [Paragraph, ParagraphAnalysisResult][]) => {
    const effects = []
    for (const result of analysisResults) {
        const [paragraph, paragraphAnalysisResult] = result
        const { analysisData } = paragraphAnalysisResult
        if (analysisData) {
            effects.push(paragraphAnalyzed.of({ lineNumber: paragraph.lineNumber, value: analysisData }))
            _log('- adding marker effect', paragraph.lineNumber, createMark(paragraph))
            effects.push(addMarkerEffect.of({ from: paragraph.from, to: paragraph.to, marker: createMark(paragraph) }))
        }
    }
    return effects
}

const viewportLinesToCheck = (
    lineTracker: LineTracker,
    firstCheck: boolean,
    view: EditorView
) => {
    const doc = view.state.doc
    const firstLineNumber = doc.lineAt(view.viewport.from).number
    const lastLineNumber = doc.lineAt(view.viewport.to).number
    _log('- viewport lines', firstLineNumber, lastLineNumber)
    const lines = []
    for (
        let lineNumber = firstLineNumber;
        lineNumber <= lastLineNumber;
        lineNumber++
    ) {
        if (!lineTracker.lineHasChanged(lineNumber)) {
            continue
        }
        lines.push(view.state.doc.line(lineNumber))
    }
    _log(
        '- lines to check',
        lines.map(l => l.number)
    )
    return lines
}

const createMark = (paragraph: Paragraph) => new ParagraphAnalysisMarker(paragraph)