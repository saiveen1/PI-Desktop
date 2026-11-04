/** Shared actions for every file reference in the conversation. */
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import {
  IconBrowser,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFileText,
  IconFolderOpen,
  IconGlobe,
} from "../components/icons";
import { isHtmlFilePath, parseFileRefPosition } from "../lib/chat-links";
import { useChatNativeFilesAllowed } from "./use-chat-session-capability";
import { useChatFileAction } from "./use-chat-file-action";
import { useCopyChatFileRef, useOpenChatFileRef } from "./use-preview-target";

export type ChatFileMenuTarget = {
  /** The reference as the surface spelled it, before completion. */
  path: string;
  /** Markdown file the reference was read from, for `./` and `../`. */
  baseDir?: string;
  line?: number;
  column?: number;
};

export function useChatFileMenuItems() {
  const { t } = useTranslation();
  const nativeFilesAllowed = useChatNativeFilesAllowed();
  const openFileRef = useOpenChatFileRef();
  const copyFileRef = useCopyChatFileRef();
  const fileAction = useChatFileAction();
  return useCallback(
    ({ path, baseDir, line, column }: ChatFileMenuTarget): ContextMenuItem[] => {
      const position = parseFileRefPosition(path);
      const html = isHtmlFilePath(path);
      return [
        ...(nativeFilesAllowed ? [
          {
            id: "open-file",
            label: t("chat.fileMenuOpen"),
            icon: <IconFileText size={14} />,
            onSelect: () => openFileRef(path, baseDir, undefined, {
              line: line ?? position?.line, column: column ?? position?.column,
            }),
          },
          {
            id: "open-with",
            label: t("chat.openWith"),
            icon: <IconExternal size={14} />,
            submenu: [
              {
                id: "open-with-file-manager",
                label: t("chat.openWithFileManager"),
                icon: <IconFolderOpen size={14} />,
                onSelect: () => openFileRef(path, baseDir, undefined, { destination: "file-manager" }),
              },
              ...(html ? [
                {
                  id: "open-with-built-in-browser",
                  label: t("chat.openWithBuiltInBrowser"),
                  icon: <IconBrowser size={14} />,
                  onSelect: () => openFileRef(path, baseDir, undefined, { destination: "built-in-browser" }),
                },
                {
                  id: "open-with-default-browser",
                  label: t("chat.openWithDefaultBrowser"),
                  icon: <IconGlobe size={14} />,
                  onSelect: () => openFileRef(path, baseDir, undefined, { destination: "default-browser" }),
                },
              ] : [{
                id: "open-with-default-application",
                label: t("chat.openFile"),
                icon: <IconExternal size={14} />,
                onSelect: () => { void fileAction("open-default", path, baseDir); },
              }]),
            ],
          },
          {
            id: "save-as",
            label: t("chat.fileSaveAs"),
            icon: <IconDownload size={14} />,
            separatorBefore: true,
            onSelect: () => { void fileAction("save-as", path, baseDir); },
          },
        ] : []),
        {
          id: "copy-full-path",
          label: t("chat.copyFullPath"),
          icon: <IconCopy size={14} />,
          onSelect: () => copyFileRef(path, baseDir, "absolute"),
        },
        {
          id: "copy-relative-path",
          label: t("chat.copyRelativePath"),
          icon: <IconCopy size={14} />,
          onSelect: () => copyFileRef(path, baseDir, "relative"),
        },
        ...(nativeFilesAllowed ? [
          {
            id: "copy-file-content",
            label: t("chat.copyFileContents"),
            icon: <IconCopy size={14} />,
            onSelect: () => { void fileAction("copy-content", path, baseDir); },
          },
          {
            id: "reveal-in-folder",
            label: t("chat.showFileInFolder"),
            icon: <IconFolderOpen size={14} />,
            onSelect: () => { void fileAction("reveal", path, baseDir); },
          },
        ] : []),
      ];
    },
    [copyFileRef, fileAction, nativeFilesAllowed, openFileRef, t],
  );
}

/** Each surface owns its menu; Markdown shares one across all its links. */
export function useChatFileMenu() {
  const fileMenuItems = useChatFileMenuItems();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const openFileMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, target: ChatFileMenuTarget) =>
      openContextMenu(event, { items: fileMenuItems(target) }),
    [fileMenuItems, openContextMenu],
  );
  return { fileMenu: contextMenu, openFileMenu, closeFileMenu: closeContextMenu };
}
