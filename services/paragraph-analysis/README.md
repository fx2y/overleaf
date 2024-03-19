# Paragraph Analysis Service

## Prerequisites

It's not intended to be used as a real service. It's created to show the concept of calling analysis service from Overleaf web app through custom extensions concept that is inherently accommodated by the platform.

In order to run the demo, you should first run the Overleaf platform. You can refer to [the instruction](../../develop/README.md) for running the development services. 

```shell
# Assume you're inside that directory
# Build the services
docker compose build --pull

# Initialize the db
docker compose up --detach mongo
curl --max-time 10 --retry 5 --retry-delay 5 --retry-all-errors --silent --output /dev/null localhost:27017
docker compose exec mongo mongosh --eval "rs.initiate({ _id: 'overleaf', members: [{ _id: 0, host: 'mongo:27017' }] })"
docker compose down mongo
```

## Running the Demo

```shell
# Assume you're inside the develop directory
# 
docker compose up --detach
```

Then, you can initialize the first admin account through http://localhost/launchpad.

In order to run the paragraph analysis API, you can execute

```shell
python api.py
```

Then, you should be able to change or edit the project and the paragraph analysis feature is automatically enabled.

The system will try to call the API whenever they decide that the line is updated. Please take note that the API is only called only for that specific line that is changed.

For another entrypoint, it will try to fetch the analysis when you scroll up / down (basically, whenever viewport is changed) for all paragraph that isn't covered by previous screen.