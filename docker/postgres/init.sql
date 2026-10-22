-- Runs once, when the volume is first created. Tests get their own database and create a
-- throwaway schema per test inside it, so they never touch dev data.
CREATE DATABASE slacky_test OWNER slacky;
\connect slacky_test
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
\connect slacky
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
