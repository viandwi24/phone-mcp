import type { UiNode } from "./index.ts";

const b = (l: number, t: number, r: number, bt: number) => ({ l, t, r, b: bt });
const PKG = "com.example.shop";

/** A realistic search-results screen: toolbar, search box, tabs, a list of cards, bottom nav, plus layout wrappers. */
export const searchScreen: UiNode = {
  class: "android.widget.FrameLayout",
  pkg: PKG,
  bounds: b(0, 0, 1080, 2400),
  children: [
    {
      class: "android.widget.LinearLayout",
      pkg: PKG,
      bounds: b(0, 0, 1080, 2400),
      children: [
        {
          class: "android.view.ViewGroup",
          viewId: `${PKG}:id/toolbar`,
          pkg: PKG,
          bounds: b(0, 80, 1080, 240),
          children: [
            { class: "android.widget.ImageButton", desc: "Navigate up", clickable: true, pkg: PKG, bounds: b(0, 80, 160, 240) },
            { class: "android.widget.TextView", text: "Search results", pkg: PKG, bounds: b(180, 120, 700, 200) },
            { class: "android.view.View", pkg: PKG, bounds: b(900, 100, 900, 220) }, // zero width, dropped
          ],
        },
        {
          class: "android.widget.EditText",
          viewId: `${PKG}:id/search_input`,
          text: "running shoes",
          editable: true,
          clickable: true,
          focused: true,
          pkg: PKG,
          bounds: b(40, 260, 1040, 380),
        },
        {
          class: "android.widget.HorizontalScrollView",
          scrollable: true,
          pkg: PKG,
          bounds: b(0, 400, 1080, 520),
          children: [
            { class: "android.widget.TextView", text: "All", clickable: true, selected: true, pkg: PKG, bounds: b(0, 400, 200, 520) },
            { class: "android.widget.TextView", text: "Men", clickable: true, pkg: PKG, bounds: b(200, 400, 400, 520) },
            { class: "android.widget.TextView", text: "Women", clickable: true, pkg: PKG, bounds: b(400, 400, 600, 520) },
          ],
        },
        {
          class: "androidx.recyclerview.widget.RecyclerView",
          viewId: `${PKG}:id/results`,
          scrollable: true,
          pkg: PKG,
          bounds: b(0, 520, 1080, 2100),
          children: [
            card(0, "Trail Runner X", "$89.00", false),
            card(1, "Road Glide 3", "$120.00", true),
            card(2, "Sprint Pro", "$65.50", false),
          ],
        },
        {
          class: "android.view.ViewGroup",
          viewId: `${PKG}:id/bottom_nav`,
          pkg: PKG,
          bounds: b(0, 2120, 1080, 2400),
          children: [
            { class: "android.widget.FrameLayout", desc: "Home", clickable: true, pkg: PKG, bounds: b(0, 2120, 360, 2400) },
            { class: "android.widget.FrameLayout", desc: "Cart", clickable: true, pkg: PKG, bounds: b(360, 2120, 720, 2400) },
            { class: "android.widget.FrameLayout", desc: "Profile", clickable: true, pkg: PKG, bounds: b(720, 2120, 1080, 2400) },
          ],
        },
      ],
    },
  ],
};

function card(i: number, name: string, price: string, fav: boolean): UiNode {
  const top = 520 + i * 500;
  return {
    class: "android.view.ViewGroup",
    viewId: `${PKG}:id/card`,
    clickable: true,
    pkg: PKG,
    bounds: b(20, top, 1060, top + 480),
    children: [
      { class: "android.widget.ImageView", pkg: PKG, bounds: b(20, top, 1060, top + 300) }, // unlabeled image, dropped
      { class: "android.widget.TextView", text: name, pkg: PKG, bounds: b(40, top + 310, 700, top + 380) },
      { class: "android.widget.TextView", text: price, pkg: PKG, bounds: b(40, top + 390, 400, top + 460) },
      {
        class: "android.widget.CheckBox",
        desc: "Favorite",
        checkable: true,
        checked: fav,
        clickable: true,
        pkg: PKG,
        bounds: b(900, top + 320, 1040, top + 460),
      },
    ],
  };
}

export function bigTree(n: number): UiNode {
  return {
    class: "android.widget.FrameLayout",
    pkg: PKG,
    bounds: b(0, 0, 1080, 2400),
    children: Array.from({ length: n }, (_, i) => ({
      class: "android.widget.TextView",
      text: `Row number ${i} with some reasonably long text`,
      clickable: true,
      pkg: PKG,
      bounds: b(0, i * 10, 1080, i * 10 + 9),
    })),
  };
}
