export const personas = [
  {
    id: 'engineer', name: 'Software Engineer', symbol: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
    heading: 'Build, debug, and verify',
    description: 'Start with expected behavior and constraints. Review changes, then verify them with tests.',
    placeholder: 'Describe a feature, bug, or code change...',
    actions: ['Diagnose a bug', 'Plan a feature', 'Review code'],
    starters: ['Help me diagnose a bug. Ask for the symptoms and expected behavior first.', 'Plan a feature with me. Clarify constraints and acceptance tests before proposing changes.', 'Review code with me for correctness and regression risks.'],
  },
  {
    id: 'intelligence', name: 'Business Intelligence', symbol: 'M4 3v17h17M8 16v-5m5 5V7m5 9V4',
    heading: 'Turn data into a decision',
    description: 'Define the business question, metric, and data source. Separate measured evidence from assumptions.',
    placeholder: 'What decision should the data help you make?',
    actions: ['Define metrics', 'Analyze data', 'Explain a trend'],
    starters: ['Help me frame a business question and define the metrics that answer it.', 'Help me analyze a dataset. Ask about its source, grain, and quality first.', 'Help me explain a trend with evidence, caveats, and a recommended next step.'],
  },
  {
    id: 'blogger', name: 'Blogger', symbol: 'm4 20 4-1 12-12-3-3L5 16l-1 4Zm10-13 3 3M4 22h16',
    heading: 'Shape a story worth reading',
    description: 'Choose an audience, angle, and voice. Move from outline to draft to editorial review.',
    placeholder: 'Describe your topic, audience, and point of view...',
    actions: ['Find an angle', 'Build an outline', 'Edit a draft'],
    starters: ['Help me find a strong angle for a blog post. Ask about my audience and purpose.', 'Build a blog outline with me before drafting.', 'Help me edit a post for clarity and voice without inventing facts.'],
  },
  {
    id: 'social', name: 'Social Media', symbol: 'm3 10 12-5v14L3 14v-4Zm3 5 2 6h3l-2-5m9-7 3-2m-3 6h4m-4 4 3 2',
    heading: 'Make the message fit the channel',
    description: 'Set the platform, audience, and objective. Compare hooks and variants before publishing yourself.',
    placeholder: 'Which platform, audience, and message are you targeting?',
    actions: ['Shape a post', 'Compare hooks', 'Plan a series'],
    starters: ['Help me shape a social post. Ask about the platform, audience, and objective.', 'Create several hook options from my message, keeping every claim grounded.', 'Plan a content series with me. Clarify cadence and approval needs first.'],
  },
  {
    id: 'presentations', name: 'Presentations', symbol: 'M3 4h18v12H3V4Zm9 12v6m-4 0 4-4 4 4M7 8h10M7 12h6',
    heading: 'Build an audience-first narrative',
    description: 'Define the takeaway and story arc. Plan slide messages, supporting visuals, and speaker notes.',
    placeholder: 'Who is the audience, and what should they take away?',
    actions: ['Plan the story', 'Outline slides', 'Rehearse'],
    starters: ['Help me plan a presentation. Ask about the audience, desired outcome, and time limit.', 'Turn my ideas into a slide-by-slide story before drafting slides.', 'Help me rehearse a presentation with speaker notes and likely audience questions.'],
  },
  {
    id: 'markdown', name: 'Markdown', symbol: 'M2 5h20v14H2V5Zm3 11V8l3 4 3-4v8m6-8v8m-3-3 3 3 3-3',
    heading: 'Write clear, structured documentation',
    description: 'Organize headings, links, tables, and examples. Check structure and accuracy before saving.',
    placeholder: 'Describe the document and who will use it...',
    actions: ['Structure a document', 'Improve a README', 'Review Markdown'],
    starters: ['Help me structure a Markdown document. Ask about its audience and purpose.', 'Help me improve a README with accurate setup steps and examples.', 'Review my Markdown for clear headings, useful links, and readable tables.'],
  },
  {
    id: 'learning', name: 'Learning Coach', symbol: 'm2 9 10-5 10 5-10 5L2 9Zm4 2v6q6 5 12 0v-6m4-2v8',
    heading: 'Skill up through conversation',
    description: 'Start with what you know and a learning goal. Use short explanations, worked examples, and practice to check understanding.',
    placeholder: 'What do you want to learn, and what do you already know?',
    actions: ['Set a learning goal', 'Learn by example', 'Check understanding'],
    starters: ['Coach me on a new topic. Ask what I know, my goal, and how much time I have.', 'Teach me through one worked example, then give me a small practice challenge.', 'Check my understanding with one question at a time and explain any gaps.'],
  },
] as const

export type PersonaId = 'default' | typeof personas[number]['id']
export const personaStorageKey = 'prudence.persona'

export function isPersonaId(value: string): value is PersonaId {
  return value === 'default' || personas.some((persona) => persona.id === value)
}
