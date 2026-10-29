import { createCn } from 'cn/config';

/**
 * Class merging that knows our theme. The macOS text styles (`text-body`,
 * `text-callout` …) are font sizes; unconfigured, `cn` takes any unknown
 * `text-*` for a colour and drops it next to `text-muted-foreground`.
 * shadcn components import `cn` from here, not from the `cn` package.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: ['footnote', 'subheadline', 'callout', 'body', 'title3', 'title2', 'title1']
        }
      ]
    }
  }
});
