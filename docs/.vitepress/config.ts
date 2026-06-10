// @ts-expect-error - missing types
import markdownItTaskLists from 'markdown-it-task-lists'
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Regesta',
  description:
    'A transparent, secure, modern, scalable universal package registry.',
  lang: 'en-US',
  lastUpdated: true,
  markdown: {
    theme: {
      dark: 'github-dark',
      light: 'github-light',
    },
    config(md) {
      md.use(markdownItTaskLists)
    },
  },
  themeConfig: {
    nav: [
      { link: '/getting-started', text: 'Getting Started' },
      {
        items: [
          { link: '/why-regesta', text: 'Why Regesta' },
          { link: '/architecture', text: 'Architecture' },
          { link: '/governance', text: 'Governance' },
          { link: '/roadmap', text: 'Roadmap' },
        ],
        text: 'Vision',
      },
      {
        items: [
          { link: '/protocol', text: 'Protocol' },
          { link: '/schema', text: 'Schema' },
          { link: '/projections', text: 'Projections' },
          { link: '/api', text: 'API' },
          { link: '/operations', text: 'Operations' },
          { link: '/mirroring', text: 'Mirroring' },
        ],
        text: 'Implementation',
      },
    ],
    outline: {
      label: 'On this page',
      level: [2, 3],
    },
    search: {
      provider: 'local',
    },
    sidebar: [
      {
        items: [
          { link: '/why-regesta', text: 'Why Regesta' },
          { link: '/architecture', text: 'Architecture' },
          { link: '/governance', text: 'Governance' },
          { link: '/roadmap', text: 'Roadmap' },
        ],
        text: 'Vision',
      },
      {
        items: [
          { link: '/getting-started', text: 'Getting Started' },
          { link: '/protocol', text: 'Protocol' },
          { link: '/schema', text: 'Schema' },
          { link: '/projections', text: 'Projections' },
          { link: '/api', text: 'API' },
          { link: '/operations', text: 'Operations' },
          { link: '/mirroring', text: 'Mirroring' },
        ],
        text: 'Implementation',
      },
    ],
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/regesta-dev/draft',
      },
    ],
  },
})
