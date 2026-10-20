import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { loader } from "fumadocs-core/source";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";

// The macro is compiled away by the fumadocs-mdx bundler plugin in next.config.ts; dir is relative to packages/web.
// Options set here replace the default MDX setup, so the preset keeps it and only adds the step that turns a
// ```mermaid code block into the Mermaid component.
const docs = defineDocs({
  dir: "content/docs",
  docs: { mdxOptions: applyMdxPreset({ remarkPlugins: [remarkMdxMermaid] }) },
});

export const source = loader({ baseUrl: "/docs", source: docs.toFumadocsSource() });
