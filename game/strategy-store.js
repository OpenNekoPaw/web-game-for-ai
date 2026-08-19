import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const strategiesDirectory = fileURLToPath(new URL('../strategies/ddz/', import.meta.url));
const DEFAULT_STRATEGY_ID = 'default';

export function listStrategies() {
  const strategies = readdirSync(strategiesDirectory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => readStrategyFile(join(strategiesDirectory, name)));
  if (!strategies.length) throw new Error('strategies_unavailable');
  return {
    defaultStrategyId: strategies.some((item) => item.id === DEFAULT_STRATEGY_ID) ? DEFAULT_STRATEGY_ID : strategies[0].id,
    strategies: strategies.map(({ markdown, ...metadata }) => metadata)
  };
}

export function getStrategy(strategyId) {
  const config = listStrategies();
  const resolvedId = strategyId || config.defaultStrategyId;
  const file = readdirSync(strategiesDirectory).find((name) => name === `${resolvedId}.md`);
  if (!file) throw new Error('strategy_not_found');
  return readStrategyFile(join(strategiesDirectory, file));
}

function readStrategyFile(path) {
  const markdown = readFileSync(path, 'utf8');
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error('invalid_strategy');
  const metadata = Object.fromEntries(match[1].split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error('invalid_strategy');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  if (!metadata.id || !metadata.name) throw new Error('invalid_strategy');
  const fileStats = statSync(path);
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description || '',
    updatedAt: fileStats.mtimeMs,
    hash: createHash('sha256').update(markdown).digest('hex').slice(0, 12),
    markdown
  };
}
