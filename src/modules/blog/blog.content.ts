import sanitizeHtml from 'sanitize-html';

const IFRAME_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
];

/**
 * Post bodies are rendered unescaped on the public website and in the app, so
 * they are cleaned on every write. Inline styles are kept because articles
 * imported from Firestore rely on them for layout.
 */
export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'figure',
      'figcaption',
      'iframe',
      'h1',
      'h2',
      'span',
      'u',
      's',
      'mark',
      'sub',
      'sup',
      'del',
      'ins',
    ],
    allowedAttributes: {
      '*': ['id', 'class', 'style', 'title', 'dir', 'lang', 'data-background-image'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading'],
      iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'loading'],
      td: ['colspan', 'rowspan', 'align'],
      th: ['colspan', 'rowspan', 'align', 'scope'],
      ol: ['start', 'type', 'reversed'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedIframeHostnames: IFRAME_HOSTS,
    // Imported articles are whole HTML documents; their <title> text must not leak into the body.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
        return { tagName, attribs };
      },
    },
  }).trim();
}

export function plainText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'title', 'head'],
  })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reading time at ~220 words per minute, never below one minute. */
export function readingMinutes(html: string): number {
  const words = plainText(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

/**
 * First ~160 characters of the body's paragraphs, cut on a word boundary.
 * Paragraphs are preferred so a heading that repeats the title is skipped.
 */
export function excerptFrom(html: string, max = 160): string {
  const paragraphs = [...html.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)]
    .map((m) => plainText(m[0]))
    .join(' ');
  const text = paragraphs.length >= 60 ? paragraphs : plainText(html);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 80 ? cut.slice(0, boundary) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

export function slugify(value: string, max = 200): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** Tags are stored lowercase so a tag's URL slug maps back to it unambiguously. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48);
    if (tag) seen.add(tag);
  }
  return [...seen];
}

export const tagSlug = (tag: string) => tag.replace(/ /g, '-');
export const tagFromSlug = (slug: string) => slug.toLowerCase().replace(/-/g, ' ').trim();
