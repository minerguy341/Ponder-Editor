#!/usr/bin/env node
// Prints size and block count of a cached ponder schematic: node tools/scenegen/schem-info.mjs <schematic path, e.g. cog/small>
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './convert.mjs';
import { readNbtGz } from './nbt.mjs';
const id = process.argv[2];
const file = path.join(ROOT, 'tools/.cache/create/src/main/resources/assets/create/ponder', id + '.nbt');
const root = readNbtGz(fs.readFileSync(file));
const d = root.value ?? root;
console.log(JSON.stringify({ size: d.size, blocks: d.blocks?.length ?? null, palette: d.palette?.length ?? null }));
