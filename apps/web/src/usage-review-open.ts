let open = () => {};

export const bindUsageReview = (fn: () => void) => {
  open = fn;
  return () => { if (open === fn) open = () => {}; };
};

export const openUsageReview = () => open();
