#!/bin/sh
# render the 4 reference states of the UI (mock viewer/player) at 1920x1009 into tools/verify/out/d/
cd "$(dirname "$0")/.."
node tools/d-shot.mjs ours1.png create:cog/small 162 && \
node tools/d-shot.mjs ours2.png create:chain_conveyor/relay 77 && \
node tools/d-shot.mjs ours3.png create:press/pressing 640 && \
node tools/d-shot.mjs ours4.png create:press/compacting 126
