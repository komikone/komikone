export const inputCls =
  'w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500';
export const labelCls = 'block text-xs text-gray-400 mb-1.5 font-medium';

export function badgeTypeLabel(t: 'ADULT' | 'JUNIOR') {
  return t === 'ADULT' ? 'Adult' : 'Jr / Sr / Military';
}
