import type { DragEvent, PointerEvent } from 'react';

// A row that can be dragged and holds buttons (the close X of a tab or pane row) must not start a drag from one of those buttons.
// `dragstart` cannot tell: the browser reports the draggable row itself as `event.target`, never the button that was pressed.
// So the press is remembered when the pointer goes down (`notePress` on the row's `onPointerDownCapture`) and read when the drag starts.
let pressedOnButton = false;
const release = () => { pressedOnButton = false; };

export function notePress(event: PointerEvent) {
  pressedOnButton = event.target instanceof Element && event.target.closest('button') !== null;
  // A click ends with pointerup (a drag does not), so a press that turned into a click is forgotten and cannot affect a later drag.
  if (pressedOnButton) document.addEventListener('pointerup', release, { once: true, capture: true });
}

// True when this drag was pressed on a button (or reports one as its target). The press is used up either way.
export function dragStartsOnButton(event: DragEvent) {
  const pressed = pressedOnButton;
  pressedOnButton = false;
  return pressed || (event.target instanceof Element && event.target.closest('button') !== null);
}
