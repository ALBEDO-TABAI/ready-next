import React from 'react'

interface ErrorBoundaryProps {
    children: React.ReactNode
    fallback?: React.ReactNode
}

interface ErrorBoundaryState {
    hasError: boolean
    error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error }
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, errorInfo)
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null })
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback
            }

            return (
                <div
                    className="flex flex-col items-center justify-center h-full gap-4 p-8"
                    style={{ background: 'var(--rn-solid)', color: 'var(--rn-ink)' }}
                >
                    <div className="text-4xl">😵</div>
                    <h2 className="text-[15px] font-medium" style={{ color: 'var(--rn-ink)' }}>
                        出了点问题
                    </h2>
                    <p className="text-[13px] text-center max-w-[400px]" style={{ color: 'var(--rn-ink-2)' }}>
                        应用遇到了一个意外错误。你可以尝试刷新页面或重置。
                    </p>
                    {this.state.error && (
                        <pre
                            className="text-[11px] p-3 rounded-[var(--rn-r-card)] max-w-[500px] overflow-auto"
                            style={{
                                background: 'color-mix(in srgb, var(--rn-bad) 12%, transparent)',
                                color: 'var(--rn-bad)',
                                boxShadow: 'inset 0 0 0 .5px var(--rn-bad)'
                            }}
                        >
                            {this.state.error.message}
                        </pre>
                    )}
                    <div className="flex gap-2">
                        <button
                            onClick={this.handleReset}
                            className="h-8 px-4 rounded-full text-[13px] font-medium transition-colors"
                            style={{
                                background: 'var(--rn-btn-ink-bg)',
                                boxShadow: 'var(--rn-btn-ink-shadow)',
                                color: 'var(--rn-on-inverse)'
                            }}
                        >
                            重试
                        </button>
                        <button
                            onClick={() => window.location.reload()}
                            className="h-8 px-4 rounded-full text-[13px] transition-colors"
                            style={{
                                background: 'var(--rn-inlay)',
                                boxShadow: 'inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2), var(--rn-shadow-1)',
                                color: 'var(--rn-ink)'
                            }}
                        >
                            刷新页面
                        </button>
                    </div>
                </div>
            )
        }

        return this.props.children
    }
}
