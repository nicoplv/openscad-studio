import { useState, useEffect } from 'react';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../stores/layoutStore';

export function useMobileLayout() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return { isMobile };
}
