# FoodFlow frontend: design notes

## Direction
Food delivery in Dhaka. The customer's first question is **"what can I get, and how soon?"**, so the interface is location-first and the delivery estimate is the hero of every restaurant.

| Token | Value | Use |
|---|---|---|
| Paper | `#FFFFFF` (panels `#F2F5F1`, lines `#D9E0DA`) | surfaces |
| Ink | `#10261C` (banana-leaf green-black) | text, dark surfaces, focus ring |
| **Holud** (turmeric) | `#F7B500` | the single accent: primary buttons, the ticket, selected states. Always carries ink text; never thin text on white (small accent text uses `#8A5E00`) |
| Morich (chili) | `#C7341A` | errors and destructive actions |
| Dhonia (green) | `#1B7F51` | success |

* **Type:** Bricolage Grotesque (headings) + Hind Siliguri (body, also covers Bengali for later localisation). Both self-hosted through `@fontsource`; no runtime font requests.
* **Radii by role:** tile 14 · control 12 · card 20 · ticket 6.
* **Memorable element: the order ticket.** The ETA stub on every restaurant and the status slip on the order page are notched turmeric tickets with a perforated divider, echoing the tickets kitchens print for each order. Used for those two things only.
* **Imagery:** until restaurants upload photos, a plate on a per-restaurant tinted tile stands in (labelled "no photo yet" for screen readers).
* **Motion:** none decorative. Only skeleton pulse and dialog fade; all disabled under `prefers-reduced-motion`.

## Review against the generic defaults
* Warm cream + terracotta/tomato (the look of most generated food UIs) was the first instinct and the earlier scaffold's palette; replaced with white + green-black ink + turmeric.
* Avoided Foodpanda's pink and the usual red/orange food-app colours.
* No shadows-on-everything card kit: structure comes from 1 px lines and spacing.
* No eyebrow labels, numbered markers or decorative gradients.

## Accessibility decisions
Skip link; one `h1` per page; every form control labelled with errors announced (`role="alert"`); keyboard-operable Radix dialogs/menus/radios/checkboxes; visible 2 px ink focus ring; status never conveyed by colour alone (text label always present); per-page document titles; touch targets ≥ 40 px.

## Not yet audited
No browser was available where this was built, so **visual QA, real keyboard/screen-reader passes, contrast measurement in context and mobile layout checks are still to do.** Treat the above as intent, not as an audit result.
