#!/bin/bash

# ─── 1. CHECK INPUT WAS PROVIDED ─────────────────────────────────────────────
if [ -z "$1" ]; then
    echo "Usage: bash setup.sh <path-to-file-or-directory>"
    echo "Examples:"
    echo "  bash setup.sh ./py-docker/src/main.py"
    echo "  bash setup.sh ./jav-docker/src/Main.java"
    echo "  bash setup.sh ./rust-docker/src/main.rs"
    echo "  bash setup.sh ./py-docker"
    exit 1
fi

INPUT=$1

# ─── 2. RESOLVE FILE OR DIRECTORY INPUT ──────────────────────────────────────
if [ -f "$INPUT" ]; then
    EXT="${INPUT##*.}"
    SRC_DIR=$(dirname "$INPUT")
    PROJECT_DIR=$(dirname "$SRC_DIR")

elif [ -d "$INPUT" ]; then
    if [ -f "$INPUT/src/main.py" ]; then
        EXT="py"
    elif [ -f "$INPUT/src/Main.java" ]; then
        EXT="java"
    elif [ -f "$INPUT/src/main.rs" ]; then
        EXT="rs"
    else
        echo "Error: No recognizable source file found in $INPUT/src/"
        exit 1
    fi
    PROJECT_DIR="$INPUT"

else
    echo "Error: $INPUT is not a valid file or directory"
    exit 1
fi

# ─── 3. DETECT LANGUAGE ───────────────────────────────────────────────────────
case $EXT in
    py)   LANG="python" ;;
    java) LANG="java"   ;;
    rs)   LANG="rust"   ;;
    *)
        echo "Error: Unsupported file type .${EXT}"
        echo "Supported: .py .java .rs"
        exit 1
        ;;
esac

echo "Detected language : $LANG"
echo "Project directory : $PROJECT_DIR"

# ─── 4. ASSIGN NAMES AND PORTS ───────────────────────────────────────────────
case $LANG in
    python)
        IMAGE_NAME="python-webpage"
        CONTAINER_NAME="python-site"
        HOST_PORT=9001
        CONTAINER_PORT=5000
        ;;
    java)
        IMAGE_NAME="java-webpage"
        CONTAINER_NAME="java-site"
        HOST_PORT=9000
        CONTAINER_PORT=8000
        ;;
    rust)
        IMAGE_NAME="rust-webpage"
        CONTAINER_NAME="rust-site"
        HOST_PORT=9002
        CONTAINER_PORT=3000
        ;;
esac

# ─── 5. STOP AND REMOVE EXISTING CONTAINER ───────────────────────────────────
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "Stopping existing container: $CONTAINER_NAME"
    docker stop $CONTAINER_NAME
    docker rm $CONTAINER_NAME
fi

# ─── 6. GENERATE DOCKERFILE ───────────────────────────────────────────────────
echo "Generating Dockerfile for $LANG..."

if [ "$LANG" = "python" ]; then

cat > $PROJECT_DIR/requirements.txt << 'EOF'
flask
EOF

cat > $PROJECT_DIR/Dockerfile << 'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY src/main.py /app/src/main.py
COPY html/ /app/html/
EXPOSE 5000
CMD ["python", "/app/src/main.py"]
EOF

elif [ "$LANG" = "java" ]; then

cat > $PROJECT_DIR/Dockerfile << 'EOF'
FROM eclipse-temurin:21-jdk-jammy
WORKDIR /app
COPY src/Main.java /app/src/Main.java
COPY html/ /app/html/
RUN mkdir -p /app/out && javac -d /app/out /app/src/Main.java
EXPOSE 8000
CMD ["java", "-cp", "/app/out", "Main"]
EOF

elif [ "$LANG" = "rust" ]; then

cat > $PROJECT_DIR/Dockerfile << 'EOF'
FROM rust:1.86-slim
WORKDIR /app
COPY Cargo.toml .
COPY src/ /app/src/
RUN cargo fetch
COPY templates/ /app/templates/
RUN cargo build --release
EXPOSE 3000
CMD ["/app/target/release/my_rust_app"]
EOF

fi

# ─── 7. BUILD IMAGE ───────────────────────────────────────────────────────────
echo "Building Docker image: $IMAGE_NAME"
docker build -t $IMAGE_NAME $PROJECT_DIR

# ─── 8. RUN CONTAINER ─────────────────────────────────────────────────────────
echo "Running container: $CONTAINER_NAME"
docker run -d -p $HOST_PORT:$CONTAINER_PORT --name $CONTAINER_NAME $IMAGE_NAME

echo "Done. Visit http://localhost:$HOST_PORT"