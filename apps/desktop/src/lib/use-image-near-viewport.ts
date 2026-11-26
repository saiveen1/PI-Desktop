import { useEffect, useState, type RefCallback } from "react";

const listeners = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;

/** An implicit document root respects all intervening overflow clips (including modal strips). */
export function useImageNearViewport<T extends HTMLElement>(): [RefCallback<T>, boolean] {
  const [element, setElement] = useState<T | null>(null);
  const [visible, setVisible] = useState<T | null>(null);
  const supported = typeof IntersectionObserver === "function";
  useEffect(() => {
    if (!element || !supported) return;
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin: "120px" });
    listeners.set(element, (near) => setVisible(near ? element : null));
    observer.observe(element);
    return () => {
      listeners.delete(element);
      observer?.unobserve(element);
      if (!listeners.size) {
        observer?.disconnect();
        observer = undefined;
      }
    };
  }, [element, supported]);
  // An older renderer without visibility observation must not strand a visible image.
  return [setElement, !!element && (!supported || visible === element)];
}
