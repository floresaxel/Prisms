-- PowerSync replicates via logical replication and requires this publication
-- on the source database (PSYNC_S1141 otherwise).
CREATE PUBLICATION powersync FOR ALL TABLES;
