const operonSystemDbSchema = `
  CREATE TABLE IF NOT EXISTS operon__FunctionOutputs (
    workflow_id VARCHAR(64) NOT NULL,
    function_id INT NOT NULL,
    output TEXT,
    error TEXT,
    PRIMARY KEY (workflow_id, function_id)
  );

  CREATE TABLE IF NOT EXISTS operon__WorkflowStatus (
    workflow_id VARCHAR(64) PRIMARY KEY,
    workflow_name TEXT,
    status VARCHAR(64),
    output TEXT,
    error TEXT,
    last_update_epoch_ms BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())*1000)::bigint
  );

  CREATE TABLE IF NOT EXISTS operon__Notifications (
    topic VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (topic, key)
  );

  CREATE OR REPLACE FUNCTION operon__NotificationsFunction() RETURNS TRIGGER AS $$
    DECLARE
        topic_key text := NEW.topic || '::' || NEW.key;
    BEGIN
        -- Publish a notification for all keys
        PERFORM pg_notify('operon__notificationschannel', topic_key);
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO
    $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'operon__notificationstrigger') THEN
          EXECUTE '
              CREATE TRIGGER operon__notificationstrigger
              AFTER INSERT ON operon__Notifications
              FOR EACH ROW EXECUTE FUNCTION operon__NotificationsFunction()';
        END IF;
    END
    $$;
`;

export default operonSystemDbSchema;
