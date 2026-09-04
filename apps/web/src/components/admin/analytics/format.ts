import { EMPTY_VALUE } from './constants';

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatPercentage(value: number) {
  return `${(value * 100).toFixed(value > 0.1 ? 1 : 2)}%`;
}

export function formatBytes(value: number) {
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }
  return `${value.toFixed(0)} ms`;
}

export function formatCellValue(value: string) {
  if (!value) return '(empty)';
  if (value === EMPTY_VALUE) return '(empty)';
  return value;
}

export function formatBooleanCell(value: string) {
  if (value === '1') return 'Yes';
  if (value === '0') return 'No';
  return value;
}

export function downloadText(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
