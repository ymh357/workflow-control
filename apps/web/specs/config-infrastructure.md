# Config Infrastructure

## Application Overview

The Config page (`/config`) is a multi-tab interface for managing system configuration. It includes Health status display (MCP and Skill readiness), Settings/MCP YAML editor, Sandbox configuration, and the Pipeline Workbench. This spec covers the infrastructure tabs: Health, Settings, and Sandbox.

## Test Scenarios

### Scenario 1: Health tab displays system status

1. Navigate to `/config`
2. Click the "Health" tab
3. Verify environment info is displayed (OS, Node version)
4. Verify preflight check items are listed with pass/fail indicators
5. Verify MCP status section shows configured MCPs
6. Verify Skills section lists available skills

**Expected:** Health tab renders system diagnostics with status indicators.

### Scenario 2: Settings tab loads and displays YAML

1. Navigate to `/config`
2. Click the "Settings" tab
3. Verify a YAML editor is rendered
4. Verify the editor contains system settings content (non-empty)

**Expected:** Settings tab shows the current system-settings.yaml in an editor.

### Scenario 3: MCP tab loads and displays YAML

1. Navigate to `/config`
2. Click the "MCP" tab
3. Verify a YAML editor is rendered with MCP registry configuration

**Expected:** MCP tab shows the MCP registry YAML in an editor.

### Scenario 4: Save settings YAML

1. Navigate to `/config` > "Settings" tab
2. Modify text in the YAML editor
3. Click the "Save" button
4. Verify a success toast or confirmation appears

**Expected:** Edited YAML is saved to the server and confirmed.

### Scenario 5: Sandbox tab displays configuration

1. Navigate to `/config`
2. Click the "Sandbox" tab
3. Verify sandbox configuration options are displayed
4. Verify toggles and inputs are interactive

**Expected:** Sandbox panel renders with editable configuration fields.
