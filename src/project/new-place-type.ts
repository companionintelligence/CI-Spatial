/**
 * What the New Place form offers as a Place's type, and which it starts on (D7).
 *
 * A Place is a whole building with its rooms as Areas, not one Place per room: the frame, the world and the
 * share boundary belong to the Place, and a house made of one Place per room is a chain of independent frames that
 * nothing relates (ADR 0009, F3). The form used to start on Room, which is what produced that chain. It starts on
 * Building now. The person can still choose any of the four, and every Place already saved keeps its type.
 *
 * In its own module so the default is one value a test can read, and not the `selected` attribute of an option in
 * a template string in src/main.ts. Deno-API-free and DOM-free (ADR 0002): it builds text.
 */
import type { PlaceType } from '../world/types.ts'

/** The type the New Place form starts on. **Adopted, not measured (ADR 0005 rule 5):** the owner's recommendation (D7). */
export const NEW_PLACE_DEFAULT_TYPE: PlaceType = 'building'

/** The types the form offers, in the order it lists them. */
export const NEW_PLACE_TYPE_OPTIONS: ReadonlyArray<{ value: PlaceType; label: string }> = [
  { value: 'building', label: 'Building' },
  { value: 'floor', label: 'Floor' },
  { value: 'room', label: 'Room' },
  { value: 'other', label: 'Other' },
]

/**
 * The label of each type: the one the form lists it under, and the one the Place picker names a Place's level by
 * (`src/viewer/viewer.ts`), so the words for the four types are in one table.
 */
export const PLACE_TYPE_LABELS: Record<PlaceType, string> = Object.fromEntries(
  NEW_PLACE_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<PlaceType, string>

/** The `<option>` elements of the form's type list, with `selected` on exactly one: the default unless told otherwise. */
export function newPlaceTypeOptionsHtml(selected: PlaceType = NEW_PLACE_DEFAULT_TYPE): string {
  return NEW_PLACE_TYPE_OPTIONS
    .map(({ value, label }) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`)
    .join('\n                  ')
}
