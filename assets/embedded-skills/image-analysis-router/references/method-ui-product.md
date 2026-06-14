# UI Product Method

Use this route for standalone interface screens: app screens, web apps, dashboards-as-product, settings panels, onboarding flows, forms, modals, landing pages, and design-tool mockups (Figma/Sketch frames).

This route judges a screen as a working surface someone must operate, not as a static composition. Marketing key art detached from interaction belongs to `graphic-design`; in-game HUD belongs to `game-visual-design`; slide or report pages belong to `presentation-document`.

## Evidence ladder

Keep claims separated by certainty:

- `FACT`: directly visible in the screenshot
- `INFERENCE`: strong read backed by visible UI conventions (platform, component library, state signals)
- `HYPOTHESIS`: plausible behavior guess that one screenshot cannot confirm (flows, animation, responsive behavior)

A single static screenshot cannot prove interaction behavior. Say what is missing: other states, other breakpoints, the steps before and after this screen.

## Core lenses

1. Screen role and user task
2. Information density and attention
3. Hierarchy and scan path
4. State clarity
5. Interaction cues and affordance
6. Component and system consistency
7. Hierarchy resilience and accessibility
8. Trust, tone, and brand fit in product context

## Analysis order

### 1. Screen role and user task

- Name the screen type: list, detail, form, dashboard, settings, onboarding, empty state, checkout, and so on.
- State the primary task this screen should let the user finish, and what success looks like.
- Note platform conventions in play: iOS, Android, web desktop, responsive mobile web.

### 2. Information density and attention

- Count what competes for attention; separate foreground task elements from background chrome.
- Judge whether density matches the task: dense is fine for operators, hostile for first-run.
- Name the one element the screen seems to want the user to act on, and whether it actually wins attention.

### 3. Hierarchy and scan path

- Trace the likely scan path: entry point, second fixation, action point.
- Check heading levels, grouping, spacing logic, and alignment grid.
- Flag hierarchy lies: visually loud elements with low task value, or critical actions visually buried.

### 4. State clarity

- Identify which state this screenshot shows: default, empty, loading, error, success, partial data.
- Check whether the visible state communicates itself: would a user know what is happening and what to do next?
- Note state evidence that is missing and would change the verdict (e.g. how errors or empty lists look).

### 5. Interaction cues and affordance

- Check tappable/hoverable/disabled differentiation: do interactive elements look interactive, and only those?
- Inspect button hierarchy: primary vs secondary vs destructive treatment.
- Look for affordance traps: links styled as text, dead-looking active controls, ambiguous icons without labels.

### 6. Component and system consistency

- Check internal consistency: spacing scale, corner radii, icon style, control sizing across the screen.
- Note where the screen drifts from its own system or from platform conventions, and whether the drift is purposeful.

### 7. Hierarchy resilience and accessibility

- Judge whether the layout survives smaller widths, longer text, and accessibility-scale font sizes.
- Check contrast risks, touch-target sizing, and color-only signals.
- Treat localization stress (longer strings, RTL) as a hypothesis when relevant.

### 8. Trust, tone, and brand fit

- Read the voice of the copy and visual tone against the product's job: playful, institutional, expert.
- For data-heavy or money-touching screens, check whether the design signals reliability where it matters.

### 9. Overall judgment

- State whether the screen lets its primary task succeed, and what most threatens that.
- Separate craft issues (spacing, alignment) from structural issues (wrong hierarchy, missing states).

## Common failure patterns

- everything emphasized, so nothing is
- primary action visually tied with secondary actions
- empty/loading/error states designed as afterthoughts or missing
- interactive and static elements styled identically
- dashboard screens optimized for looking impressive instead of being read
- system inconsistency that taxes the user on every screen transition
- accessibility treated as a contrast checkbox instead of a layout constraint

## Route-specific failure modes

- Judging a working screen with poster standards: rewarding visual drama over task success.
- Critiquing interaction behavior that a static screenshot cannot prove, stated as fact.
- Missing that the screenshot shows an edge state (empty, error) and judging it as the default.

## Study report emphasis

- recommend one hierarchy drill: re-rank the screen's elements by task value, then by visual weight, and reconcile the two lists
- recommend one state drill: design or collect the missing empty/loading/error states for this screen
- recommend one consistency drill: extract the screen's implicit spacing/type/color tokens and find the violations
- recommend one resilience drill: re-flow the layout at a narrower width or larger font size

## Actionable drill format

Every Study Report drill should be executable:

- Drill name
  - Do: state the concrete action.
  - Finish: state what counts as completed or improved.
