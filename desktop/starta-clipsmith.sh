#!/bin/sh
# Starta Clipsmith fran kallkod. Forsta gangen hamtas det som behovs (nagra minuter, kraver internet).
cd "$(dirname "$0")" || exit 1
# Appar som startas fran Finder far inte skalets PATH; lagg till de vanliga platserna for Node.
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/current/bin:$PATH"
export PATH

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js behovs for att starta programmet fran kallkod och saknas pa datorn."
  if command -v brew >/dev/null 2>&1; then
    echo "Installerar Node.js med Homebrew..."
    brew install node || { echo "Installationen misslyckades."; exit 1; }
  else
    echo "Installera Node.js (LTS) fran https://nodejs.org/en/download och starta den har filen igen."
    command -v open >/dev/null 2>&1 && open "https://nodejs.org/en/download"
    command -v xdg-open >/dev/null 2>&1 && xdg-open "https://nodejs.org/en/download" >/dev/null 2>&1
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  echo "Forsta starten: hamtar programmets delar. Det tar nagra minuter."
  npm install || { echo; echo "Installationen misslyckades. Skicka felet ovan."; exit 1; }
fi

npm start || { echo; echo "Programmet avslutades med ett fel. Skicka texten ovan."; exit 1; }
