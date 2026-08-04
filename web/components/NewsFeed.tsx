import React from 'react';

export interface NewsItem {
    id: string;
    title: string;
    summary: string;
    source: string;
    date: string;
    label: string;
    url: string;
}

const NEWS_ITEMS: NewsItem[] = [
    {
        id: '1',
        title: 'GPT-5 launch',
        summary: 'OpenAI announces the new version of its model, with advanced reasoning and lower latency.',
        source: 'OpenAI Blog',
        date: '2 hours ago',
        label: 'AI',
        url: 'https://openai.com/blog',
    },
    {
        id: '2',
        title: 'Next.js 15 Server Actions',
        summary: 'Significant improvements in stability and performance for server-side data mutations.',
        source: 'Vercel',
        date: 'Yesterday',
        label: 'Frontend',
        url: 'https://vercel.com/blog',
    },
    {
        id: '3',
        title: 'Python drops the GIL',
        summary: 'PEP 703 has been accepted, enabling true parallelism in Python threads.',
        source: 'Python.org',
        date: '3 days ago',
        label: 'Backend',
        url: 'https://python.org',
    },
    {
        id: '4',
        title: 'PostgreSQL Vector',
        summary: 'pgvector is gaining traction as the standard solution for vector databases in RAG.',
        source: 'Supabase',
        date: '5 days ago',
        label: 'Database',
        url: 'https://supabase.com/blog',
    },
    {
        id: '5',
        title: 'React Compiler Beta',
        summary: 'React ships its automatic compiler to optimize re-renders without useMemo.',
        source: 'React Team',
        date: 'Last week',
        label: 'Frontend',
        url: 'https://react.dev/blog',
    },
    {
        id: '6',
        title: 'Claude 3.5 Sonnet',
        summary: 'Anthropic releases a mid-tier model with stronger coding capabilities.',
        source: 'Anthropic',
        date: '1 week ago',
        label: 'AI',
        url: 'https://www.anthropic.com/news',
    },
];

const LABEL_COLORS: Record<string, string> = {
    'AI': 'bg-purple-100 text-purple-700',
    'Frontend': 'bg-blue-100 text-blue-700',
    'Backend': 'bg-green-100 text-green-700',
    'Database': 'bg-orange-100 text-orange-700',
};

export default function NewsFeed() {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {NEWS_ITEMS.map((item) => (
                <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block bg-white rounded-lg border border-slate-200 shadow-sm p-5 transition-all duration-200 hover:shadow-md hover:border-primary hover:-translate-y-1"
                >
                    <div className="flex justify-between items-start mb-3">
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${LABEL_COLORS[item.label] || 'bg-gray-100 text-gray-700'}`}>
                            {item.label}
                        </span>
                        <span className="text-xs text-slate-400">{item.date}</span>
                    </div>

                    <h3 className="text-dark font-bold text-lg mb-2 group-hover:text-primary transition-colors">
                        {item.title}
                    </h3>

                    <p className="text-slate-600 text-sm mb-4 line-clamp-3">
                        {item.summary}
                    </p>

                    <div className="text-xs text-slate-400 flex items-center gap-1">
                        <span>Source: {item.source}</span>
                    </div>
                </a>
            ))}
        </div>
    );
}
