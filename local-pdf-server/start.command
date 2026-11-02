#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/Library/TeX/texbin:$PATH"
exec python3 server.py
