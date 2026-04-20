#!/bin/bash

PROJECT_DIR=$1
CONTAINER_NAME=$2
HOST_PORT=$3
CONTAINER_PORT=$4

# ─── VALIDATE ────────────────────────────────────────────────────────────────
if [ -z "$PROJECT_DIR" ] || [ -z "$CONTAINER_NAME" ] || [ -z "$HOST_PORT" ] || [ -z "$CONTAINER_PORT" ]; then
    echo "Error: Missing arguments"
    echo "Usage: bash setup.sh <project_dir> <container_name> <host_port> <container_port>"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/Dockerfile" ]; then
    echo "Error: No Dockerfile found in $PROJECT_DIR"
    exit 1
fi

# ─── STOP EXISTING ───────────────────────────────────────────────────────────
if [ "$(docker ps -aq -f name=^${CONTAINER_NAME}$)" ]; then
    echo "Stopping existing container: $CONTAINER_NAME"
    docker stop $CONTAINER_NAME
    docker rm $CONTAINER_NAME
fi

# ─── BUILD ───────────────────────────────────────────────────────────────────
echo "Building image: $CONTAINER_NAME"
docker build -t $CONTAINER_NAME "$PROJECT_DIR"
if [ $? -ne 0 ]; then
    echo "Error: Docker build failed"
    exit 1
fi

# ─── RUN ─────────────────────────────────────────────────────────────────────
echo "Running container: $CONTAINER_NAME"
docker run -d -p $HOST_PORT:$CONTAINER_PORT --name $CONTAINER_NAME $CONTAINER_NAME
if [ $? -ne 0 ]; then
    echo "Error: Docker run failed"
    exit 1
fi

echo "Done."