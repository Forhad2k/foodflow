import { useEffect } from 'react';

/** Sets the browser tab / screen-reader page title for client-rendered pages. */
export function usePageTitle(title: string | undefined) {
  useEffect(() => { if (title) document.title = `${title} · FoodFlow`; }, [title]);
}
