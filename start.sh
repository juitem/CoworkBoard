#!/bin/bash

cd "$(dirname "$0")/app"

if [ ! -d "node_modules" ]; then
  echo "의존성 설치 중..."
  npm install
fi

node server.js
