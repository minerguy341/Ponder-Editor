#!/bin/sh
# G5 evidence: contact sheets of every surveyed B5 state (12 per sheet), written to tools/verify/out/b5/survey-NN.png (+ .json labels)
cd "$(dirname "$0")/.." || exit 1
mkdir -p tools/verify/out/b5
i=0
while [ $i -lt 13 ]; do
  n=$(printf "%02d" $i)
  node tools/b5-shot.mjs "tools/verify/out/b5/survey-$n.png" "?survey=1&part=$i&per=12&t=40" 1200 800 2>&1 | tail -1
  i=$((i+1))
done
echo SURVEY_SHEETS_DONE
