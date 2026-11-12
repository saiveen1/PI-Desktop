import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { foldLowInformationLines } from "../lib/fold-low-information-lines";
import { LargeTextPreview } from "./LargeTextPreview";
import { Button } from "./ui";

/** Page the original first: folding work and rendered height both stay bounded. */
export function MarkdownPlainPreview({ source, streaming }: { source: string; streaming: boolean }) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const previousSource = useRef(source);
  useEffect(() => {
    if (!source.startsWith(previousSource.current)) setShowRaw(false);
    previousSource.current = source;
  }, [source]);
  return (
    <div className="markdown-plain-fallback">
      <div role="status">{t("chat.markdownPlainTextFallback")}</div>
      <Button type="button" variant="ghost" size="sm" aria-pressed={showRaw} onClick={() => setShowRaw(!showRaw)}>
        {t(showRaw ? "chat.markdownShowFolded" : "chat.markdownShowRaw")}
      </Button>
      <LargeTextPreview
        text={source}
        followLatest={streaming}
        renderPage={(page) => showRaw ? page : foldLowInformationLines(page, (count) => t("chat.markdownFoldedLines", { count }))}
      />
    </div>
  );
}
