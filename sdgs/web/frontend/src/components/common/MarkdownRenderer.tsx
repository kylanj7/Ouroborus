import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

interface Props {
  content: string
}

export default function MarkdownRenderer({ content }: Props) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children }) => <h1 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '16px 0 8px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '6px' }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: '14px 0 6px' }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', margin: '12px 0 4px' }}>{children}</h3>,
          p: ({ children }) => <p style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.7, margin: '6px 0' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ paddingLeft: '20px', margin: '6px 0' }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ paddingLeft: '20px', margin: '6px 0' }}>{children}</ol>,
          li: ({ children }) => <li style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.7, marginBottom: '4px' }}>{children}</li>,
          strong: ({ children }) => <strong style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>{children}</strong>,
          em: ({ children }) => <em style={{ color: 'var(--text-secondary)' }}>{children}</em>,
          hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '12px 0' }} />,
          blockquote: ({ children }) => (
            <blockquote style={{
              borderLeft: '3px solid var(--accent-primary)',
              paddingLeft: '12px',
              margin: '8px 0',
              color: 'var(--text-secondary)',
              fontStyle: 'italic',
            }}>
              {children}
            </blockquote>
          ),
          code: ({ className, children, ...props }) => {
            const isInline = !className
            if (isInline) {
              return (
                <code style={{
                  background: 'rgba(255,255,255,0.06)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                  color: 'var(--accent-yellow, #ffd666)',
                }} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code style={{
                display: 'block',
                background: 'rgba(0,0,0,0.3)',
                padding: '12px 16px',
                borderRadius: '8px',
                fontSize: '12px',
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                color: 'var(--text-secondary)',
                overflowX: 'auto',
                lineHeight: 1.6,
              }} className={className} {...props}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => <pre style={{ margin: '8px 0' }}>{children}</pre>,
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '8px 0' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '12px',
              }}>
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{
              textAlign: 'left',
              padding: '8px 12px',
              borderBottom: '2px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}>
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
