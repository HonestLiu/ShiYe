#!/bin/zsh
cd "${0:A:h}"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/Library/TeX/texbin:$PATH"
exec python3 server.py
