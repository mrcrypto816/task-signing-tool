import fs from 'fs';
import path from 'path';
import { NetworkType, TaskStatus } from './types';
import { availableNetworks } from './constants';

let cachedRoot: string | null = null;

export function findContractDeploymentsRoot(): string {
  if (cachedRoot) return cachedRoot;

  let currentDir = process.cwd();
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const hasNetworkFolders = availableNetworks.some(network => {
      const netPath = path.join(currentDir, network);
      return fs.existsSync(netPath) && fs.statSync(netPath).isDirectory();
    });

    if (hasNetworkFolders) {
      cachedRoot = currentDir;
      return currentDir;
    }

    currentDir = path.dirname(currentDir);
  }

  // Safer fallback: use the current working directory instead of parent
  cachedRoot = process.cwd();
  return cachedRoot;
}

export interface DeploymentInfo {
  id: string;
  name: string;
  description: string;
  date: string;
  network: NetworkType;
  status?: TaskStatus;
  executionLinks?: Array<{
    url: string;
    label: string;
  }>;
}

const DEFAULT_DESCRIPTION = 'Smart contract upgrade deployment';
const MAX_STATUS_SEARCH_LINES = 20;
const MAX_STATUS_FOLLOW_UP_LINES = 5;

function formatUpgradeName(folderName: string): string {
  const slug = folderName.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function cleanMarkdownBlock(block: string): string {
  return block.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
}

function extractDescription(content: string): string {
  try {
    const normalized = content.replace(/\r\n/g, '\n');
    const descriptionMatch = normalized.match(/##\s*Description[^\n]*\n([\s\S]*?)(?=\n##\s+|$)/i);
    if (descriptionMatch) {
      return cleanMarkdownBlock(descriptionMatch[1]);
    }

    const lines = normalized.split('\n');
    const paragraph: string[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        if (paragraph.length > 0) break;
        continue;
      }

      if (trimmed.startsWith('#')) continue;
      if (/^status\s*:|^\s*===|^\s*-+\s*$/i.test(trimmed)) continue;

      paragraph.push(rawLine.replace(/[ \t]+$/g, ''));
    }

    const fallback = cleanMarkdownBlock(paragraph.join('\n'));
    return fallback || DEFAULT_DESCRIPTION;
  } catch (error) {
    console.warn('extractDescription fallback:', error);
    return DEFAULT_DESCRIPTION;
  }
}

function normalizeUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http')) return undefined;
  return trimmed.replace(/[)\].,]+$/, '');
}

function parseExecutionStatus(content: string): {
  status?: TaskStatus;
  executionLinks?: Array<{ url: string; label: string }>; 
} {
  try {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const statusLineIndex = lines
      .slice(0, MAX_STATUS_SEARCH_LINES)
      .findIndex(line => /status:/i.test(line));
    if (statusLineIndex === -1) {
      return {};
    }

    const statusLine = lines[statusLineIndex];
    // Normalize for case-insensitive matching
    const normalizedStatus = statusLine.toLowerCase();
    const isExecuted = normalizedStatus.includes(TaskStatus.Executed.toLowerCase());
    const isReady = normalizedStatus.includes(TaskStatus.ReadyToSign.toLowerCase());

    if (!isExecuted) {
      if (isReady) {
        return { status: TaskStatus.ReadyToSign };
      }
      return { status: TaskStatus.Pending };
    }

    const executionLinks: Array<{ url: string; label: string }> = [];
    const seenUrls = new Set<string>();

    const addLink = (label: string, maybeUrl: string | undefined) => {
      const url = maybeUrl ? normalizeUrl(maybeUrl) : undefined;
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      executionLinks.push({ label: label || 'Transaction', url });
    };

    for (const match of statusLine.matchAll(/https?:\/\/[^\s]+/g)) {
      const url = match[0];
      addLink('Transaction', url);
    }

    return { status: TaskStatus.Executed, executionLinks };
  } catch (error) {
    console.warn('Error parsing execution status:', error);
    return {};
  }
}