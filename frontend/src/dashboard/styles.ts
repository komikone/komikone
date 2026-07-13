export const inputCls =
  'w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-gray-900 dark:text-gray-50 text-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:border-blue-500';
export const labelCls = 'block text-xs text-gray-600 dark:text-gray-400 mb-1.5 font-medium';

export const cardCls =
  'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl';
export const cardInnerCls =
  'bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl';

export const primaryBtnCls =
  'bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg transition-colors';
export const secondaryBtnCls =
  'bg-gray-200 hover:bg-gray-300 text-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white transition-colors';

export const headingCls = 'text-gray-900 dark:text-white';
export const bodyLabelCls = 'text-gray-700 dark:text-gray-300';
export const mutedCls = 'text-gray-400 dark:text-gray-500';

export function badgeTypeLabel(t: 'ADULT' | 'JUNIOR') {
  return t === 'ADULT' ? 'Adult' : 'Jr / Sr / Military';
}
