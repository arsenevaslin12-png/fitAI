import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function createPageUrl(pageName) {
  return `/${pageName.toLowerCase().replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`
}

export function formatDate(dateStr, opts = {}) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', ...opts
  })
}
