from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

@app.route('/paragraph/analyze', methods=['POST'])
def analyze_paragraph():
    data = request.get_json()
    paragraphs = data.get('paragraphs', [])
    response = {
        "analysisResults": [
            {
                "index": i,
                "analysisData": {
                    "sentimentScore": 0.5,
                    "readibilityScore": 0.5,
                    "topics": ["topic1", "topic2"],
                    "summary": "summary",
                    "suggestions": ["suggestion1", "suggestion2"],
                    "references": ["reference1", "reference2"],
                    "tags": ["tag1", "tag2"]
                }
            }
            for i in range(len(paragraphs))
        ]
    }
    return jsonify(response)

if __name__ == '__main__':
    app.run(debug=True, port=5000)