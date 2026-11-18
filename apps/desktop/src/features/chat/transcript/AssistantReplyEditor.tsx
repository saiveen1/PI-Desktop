import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Textarea } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { getEditableAssistantReply } from "../../../stores/runtime/transcript-action";

type ReplyDraft = { messageId: string; source: string; value: string; saving: boolean };

export function useAssistantReplyEditor(sessionId: string, messageId?: string) {
  const editable = useAppStore((state) => messageId !== undefined &&
    getEditableAssistantReply(state, sessionId)?.id === messageId);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const owner = useRef<AbortController | null>(null);
  useEffect(() => () => owner.current?.abort(), [sessionId, messageId]);

  const begin = async () => {
    if (!editable || !messageId || owner.current) return;
    const request = new AbortController();
    owner.current = request;
    setLoading(true);
    // React may batch A→B→A; abandon the editor on the first navigation.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId ||
        state.selectingSessionId !== previous.selectingSessionId || state.page !== previous.page) request.abort();
    });
    request.signal.addEventListener("abort", () => {
      unsubscribe();
      owner.current = null;
      setLoading(false);
      setDraft(null);
    }, { once: true });
    const source = await useAppStore.getState().prepareAssistantReplyEdit(sessionId, messageId, request.signal);
    if (request.signal.aborted) return;
    if (source === null) { request.abort(); return; }
    setLoading(false);
    setDraft({ messageId, source, value: source, saving: false });
  };
  const cancel = () => owner.current?.abort();
  const save = async () => {
    const request = owner.current;
    if (!request || !messageId || !editable || !draft || draft.saving || !draft.value.trim() || draft.value === draft.source) return;
    setDraft({ ...draft, saving: true });
    const saved = await useAppStore.getState().editAssistantReply(sessionId, messageId, draft.source, draft.value, request.signal);
    if (request.signal.aborted) return;
    if (saved) request.abort();
    else setDraft(draft);
  };
  return {
    editable, loading, draft: draft?.messageId === messageId ? draft : null, begin, cancel, save,
    change: (value: string) => setDraft((current) => current ? { ...current, value } : current),
  };
}

export function AssistantReplyEditor({ messageId, editor }: {
  messageId: string;
  editor: ReturnType<typeof useAssistantReplyEditor>;
}) {
  const { t } = useTranslation();
  const { draft, editable, cancel, save, change } = editor;
  if (!draft) return null;
  return (
    <div className="message-bubble assistant-turn-fragment" data-message-id={messageId}>
      <form
        className="message-edit"
        aria-busy={draft.saving || undefined}
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <Textarea
          className="message-edit-input selectable"
          value={draft.value}
          rows={Math.min(12, Math.max(3, draft.value.split("\n").length))}
          aria-label={t("chat.editReply")}
          autoFocus
          readOnly={draft.saving}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape" && !draft.saving) {
              event.preventDefault();
              cancel();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <div className="message-edit-actions">
          <Button type="button" variant="ghost" size="sm" disabled={draft.saving} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="sm"
            disabled={!editable || draft.saving || !draft.value.trim() || draft.value === draft.source}
          >
            {t(draft.saving ? "common.saving" : "common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
