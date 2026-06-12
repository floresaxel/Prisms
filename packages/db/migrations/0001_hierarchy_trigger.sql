-- §6.7 I1 DB backstop: hierarchy typing trigger.
-- parent of roadmap=vision, project=roadmap, milestone=project,
-- task=milestone|project (or parentless when habit-spawned, I3);
-- vision and activity have no parent.
-- Mirrors core/src/graph/hierarchy.ts — core and the server enforce first;
-- this trigger is the last resort (§6.7).
CREATE FUNCTION enforce_node_hierarchy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_type text;
BEGIN
  IF NEW.parent_id IS NULL THEN
    IF NEW.node_type IN ('vision', 'task', 'activity') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'E_HIERARCHY: a % requires a parent', NEW.node_type;
  END IF;

  IF NEW.node_type IN ('vision', 'activity') THEN
    RAISE EXCEPTION 'E_HIERARCHY: a % cannot have a parent', NEW.node_type;
  END IF;

  SELECT n.node_type INTO parent_type FROM nodes n WHERE n.id = NEW.parent_id;
  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'E_HIERARCHY: parent % not found', NEW.parent_id;
  END IF;

  IF (NEW.node_type = 'roadmap'   AND parent_type = 'vision')
  OR (NEW.node_type = 'project'   AND parent_type = 'roadmap')
  OR (NEW.node_type = 'milestone' AND parent_type = 'project')
  OR (NEW.node_type = 'task'      AND parent_type IN ('milestone', 'project'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'E_HIERARCHY: a % cannot be a child of a %',
    NEW.node_type, parent_type;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER nodes_hierarchy_check
BEFORE INSERT OR UPDATE OF parent_id, node_type ON nodes
FOR EACH ROW EXECUTE FUNCTION enforce_node_hierarchy();
