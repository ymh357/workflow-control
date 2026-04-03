# Config Workbench — MCP Binding

## Application Overview

The Workbench tab on the Config page (`/config`) provides pipeline CRUD operations and stage-level MCP/Skill binding. Users can create, edit, and delete pipelines, configure individual stages with MCP checkboxes, and see validation warnings for missing capabilities.

## Test Scenarios

### Scenario 1: Pipeline list loads

1. Navigate to `/config`
2. Click the "Workbench" tab
3. Verify at least one pipeline is listed in the sidebar/dropdown

**Expected:** Workbench shows available pipelines.

### Scenario 2: Select and view pipeline stages

1. Open the Workbench tab
2. Select a pipeline
3. Verify the stage list is displayed with stage names
4. Click on a stage
5. Verify stage detail panel shows MCP checkboxes and configuration

**Expected:** Selecting a pipeline shows its stages; selecting a stage shows its detail.

### Scenario 3: Toggle MCP binding on a stage

1. Open the Workbench tab and select a pipeline
2. Select a stage
3. In the stage detail, find the MCP checkboxes
4. Toggle one MCP checkbox on
5. Verify the checkbox state changes
6. Toggle it off
7. Verify the checkbox reverts

**Expected:** MCP checkboxes are interactive and toggle state correctly.

### Scenario 4: Validation warnings for missing capabilities

1. Open the Workbench tab
2. Select a pipeline that references an unavailable MCP or skill
3. Verify a validation warning or badge appears on the affected stage

**Expected:** Stages with unmet capability requirements show warnings.

### Scenario 5: Create a new pipeline

1. Open the Workbench tab
2. Click the create/add pipeline button
3. Enter a pipeline name
4. Verify the new pipeline appears in the list

**Expected:** New pipeline is created and visible in the sidebar.

### Scenario 6: Delete a pipeline

1. Open the Workbench tab
2. Select a pipeline
3. Click the delete button
4. Confirm deletion
5. Verify the pipeline is removed from the list

**Expected:** Pipeline is deleted and no longer listed.
