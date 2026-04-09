import clsx from 'clsx'

const variants = {
  buy:     { border: 'border-accent-green', bg: 'bg-accent-green/10', text: 'text-accent-green' },
  green:   { border: 'border-accent-green', bg: 'bg-accent-green/10', text: 'text-accent-green' },
  sell:    { border: 'border-accent-red',   bg: 'bg-accent-red/10',   text: 'text-accent-red' },
  red:     { border: 'border-accent-red',   bg: 'bg-accent-red/10',   text: 'text-accent-red' },
  open:    { border: 'border-accent-blue',  bg: 'bg-accent-blue/10',  text: 'text-accent-blue' },
  closed:  { border: 'border-text-dim',     bg: 'bg-text-dim/10',     text: 'text-text-muted' },
  default: { border: 'border-text-dim',     bg: 'bg-text-dim/10',     text: 'text-text-muted' },
  paper:   { border: 'border-accent-amber', bg: 'bg-accent-amber/10', text: 'text-accent-amber' },
  scan:    { border: 'border-accent-blue',  bg: 'bg-accent-blue/10',  text: 'text-accent-blue' },
}

export default function Badge({ variant = 'open', size = 'md', children }) {
  const v = variants[variant] || variants.open
  return (
    <span
      className={clsx(
        'inline-flex items-center font-mono font-semibold uppercase tracking-wider rounded border-l-2',
        size === 'sm' ? 'px-1 py-0 text-[9px]' : 'px-1.5 py-0.5 text-[10px]',
        v.border, v.bg, v.text
      )}
    >
      {children}
    </span>
  )
}
