import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { CoinMark } from "@/components/cinema/coin-mark";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{
        title: (
          <>
            <CoinMark size={18} />
            Penny docs
          </>
        ),
        url: "/docs",
      }}
      themeSwitch={{ enabled: false }}
      sidebar={{ prefetch: false }}
      links={[
        { text: "Penny", url: "/" },
        { text: "Checks", url: "/checks" },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
