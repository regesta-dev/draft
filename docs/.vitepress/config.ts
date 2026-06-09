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
      { link: '/architecture', text: 'Architecture' },
      { link: '/protocol', text: 'Protocol' },
      { link: '/api', text: 'API' },
      { link: '/roadmap', text: 'Roadmap' },
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
          { link: '/', text: 'Overview' },
          { link: '/getting-started', text: 'Getting Started' },
          { link: '/architecture', text: 'Architecture' },
          { link: '/protocol', text: 'Protocol' },
          { link: '/api', text: 'API' },
          { link: '/roadmap', text: 'Roadmap' },
        ],
        text: 'Regesta',
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
