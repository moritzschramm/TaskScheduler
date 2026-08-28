CREATE TYPE "public"."appointment_status" AS ENUM('confirmed', 'tentative', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."calendar_window_kind" AS ENUM('working', 'shareable');--> statement-breakpoint
CREATE TYPE "public"."due_kind" AS ENUM('soft', 'hard');--> statement-breakpoint
CREATE TYPE "public"."missed_occurrence_policy" AS ENUM('rollover', 'expire');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('info', 'warning', 'alert');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('backlog_added', 'due_date_at_risk', 'hard_constraint_conflict', 'chronic_postponement', 'internal_appointment_change', 'working_window_divergence');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('pending', 'completed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."participant_status" AS ENUM('proposed', 'confirmed', 'change_requested');--> statement-breakpoint
CREATE TYPE "public"."recurrence_period" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visibility_scope" AS ENUM('private', 'team', 'group');--> statement-breakpoint
CREATE TABLE "availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"week_type_override_id" uuid,
	"weekday" smallint NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"focus_level" smallint,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_windows_weekday_range" CHECK ("availability_windows"."weekday" between 1 and 7),
	CONSTRAINT "availability_windows_minute_range" CHECK ("availability_windows"."start_min" >= 0 and "availability_windows"."end_min" <= 1440 and "availability_windows"."start_min" < "availability_windows"."end_min"),
	CONSTRAINT "availability_windows_focus_level_range" CHECK ("availability_windows"."focus_level" is null or "availability_windows"."focus_level" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "calendar_windows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"kind" "calendar_window_kind" NOT NULL,
	"weekday" smallint NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_windows_weekday_range" CHECK ("calendar_windows"."weekday" between 1 and 7),
	CONSTRAINT "calendar_windows_minute_range" CHECK ("calendar_windows"."start_min" >= 0 and "calendar_windows"."end_min" <= 1440 and "calendar_windows"."start_min" < "calendar_windows"."end_min")
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"visibility_scope" "visibility_scope" DEFAULT 'private' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "calendars_tenant_owner_name_key" UNIQUE("tenant_id","owner_id","name")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_cooldown_min" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "categories_tenant_name_key" UNIQUE("tenant_id","name"),
	CONSTRAINT "categories_cooldown_non_negative" CHECK ("categories"."default_cooldown_min" >= 0)
);
--> statement-breakpoint
CREATE TABLE "week_type_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "week_type_overrides_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "week_type_overrides_date_range" CHECK ("week_type_overrides"."start_date" < "week_type_overrides"."end_date")
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_ordered" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequences_id_tenant_key" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "task_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"period_start" date,
	"period_end" date,
	"status" "occurrence_status" DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"rolled_over_from_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_occurrences_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "task_occurrences_task_period_key" UNIQUE("task_id","period_start"),
	CONSTRAINT "task_occurrences_period_pair" CHECK (("task_occurrences"."period_start" is null) = ("task_occurrences"."period_end" is null)
          and ("task_occurrences"."period_start" is null or "task_occurrences"."period_start" < "task_occurrences"."period_end")),
	CONSTRAINT "task_occurrences_completed_at_matches_status" CHECK (("task_occurrences"."status" = 'completed') = ("task_occurrences"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"visibility_scope" "visibility_scope",
	"title" text NOT NULL,
	"notes" text,
	"parent_id" uuid,
	"depth" smallint DEFAULT 1 NOT NULL,
	"category_id" uuid,
	"estimated_duration_min" integer,
	"priority" smallint,
	"due_date" timestamp with time zone,
	"due_kind" "due_kind",
	"preferred_start_min" integer,
	"preferred_end_min" integer,
	"focus_level" smallint,
	"cooldown_override_min" integer,
	"sequence_id" uuid,
	"sequence_position" smallint,
	"recurrence_period" "recurrence_period",
	"recurrence_count" smallint,
	"missed_occurrence_policy" "missed_occurrence_policy" DEFAULT 'rollover' NOT NULL,
	"manual_floor" timestamp with time zone,
	"manual_bias" timestamp with time zone,
	"estimated_week" date,
	"defer_count" integer DEFAULT 0 NOT NULL,
	"last_defer_reason" text,
	"last_defer_at" timestamp with time zone,
	"status" "task_status" DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "tasks_depth_range" CHECK ("tasks"."depth" between 1 and 5),
	CONSTRAINT "tasks_duration_positive" CHECK ("tasks"."estimated_duration_min" is null or "tasks"."estimated_duration_min" > 0),
	CONSTRAINT "tasks_cooldown_non_negative" CHECK ("tasks"."cooldown_override_min" is null or "tasks"."cooldown_override_min" >= 0),
	CONSTRAINT "tasks_focus_level_range" CHECK ("tasks"."focus_level" is null or "tasks"."focus_level" between 1 and 5),
	CONSTRAINT "tasks_preferred_range_valid" CHECK (("tasks"."preferred_start_min" is null) = ("tasks"."preferred_end_min" is null)
          and ("tasks"."preferred_start_min" is null
               or ("tasks"."preferred_start_min" >= 0
                   and "tasks"."preferred_end_min" <= 1440
                   and "tasks"."preferred_start_min" < "tasks"."preferred_end_min"))),
	CONSTRAINT "tasks_due_pair" CHECK (("tasks"."due_date" is null) = ("tasks"."due_kind" is null)),
	CONSTRAINT "tasks_recurrence_pair" CHECK (("tasks"."recurrence_period" is null) = ("tasks"."recurrence_count" is null)
          and ("tasks"."recurrence_count" is null or "tasks"."recurrence_count" > 0)),
	CONSTRAINT "tasks_defer_count_non_negative" CHECK ("tasks"."defer_count" >= 0),
	CONSTRAINT "tasks_completed_at_matches_status" CHECK (("tasks"."status" = 'completed') = ("tasks"."completed_at" is not null)),
	CONSTRAINT "tasks_sequence_position_requires_sequence" CHECK ("tasks"."sequence_position" is null or "tasks"."sequence_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "appointment_participants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "participant_status" DEFAULT 'proposed' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_participants_appointment_user_key" UNIQUE("appointment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"visibility_scope" "visibility_scope",
	"title" text NOT NULL,
	"notes" text,
	"during" "tstzrange" NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"status" "appointment_status" DEFAULT 'confirmed' NOT NULL,
	"is_unavailability" boolean DEFAULT false NOT NULL,
	"recurrence_rule" text,
	"recurrence_timezone" text,
	"recurrence_exdates" timestamp with time zone[],
	"recurrence_parent_id" uuid,
	"recurrence_original_start" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "appointments_recurrence_needs_timezone" CHECK (("appointments"."recurrence_rule" is null) = ("appointments"."recurrence_timezone" is null)),
	CONSTRAINT "appointments_exception_pair" CHECK (("appointments"."recurrence_parent_id" is null) = ("appointments"."recurrence_original_start" is null)),
	CONSTRAINT "appointments_template_or_exception" CHECK ("appointments"."recurrence_rule" is null or "appointments"."recurrence_parent_id" is null)
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seq" bigserial NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"type" text NOT NULL,
	"params" jsonb NOT NULL,
	"group_id" uuid,
	"inverse" jsonb,
	"expected_version" integer,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commands_seq_key" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"severity" "notification_severity" NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"during" "tstzrange" NOT NULL,
	"cooldown_min" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placements_occurrence_key" UNIQUE("occurrence_id"),
	CONSTRAINT "placements_cooldown_non_negative" CHECK ("placements"."cooldown_min" >= 0)
);
--> statement-breakpoint
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_category_same_tenant_fk" FOREIGN KEY ("category_id","tenant_id") REFERENCES "public"."categories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_override_same_tenant_fk" FOREIGN KEY ("week_type_override_id","tenant_id") REFERENCES "public"."week_type_overrides"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_windows" ADD CONSTRAINT "calendar_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_windows" ADD CONSTRAINT "calendar_windows_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_owner_requires_membership_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_type_overrides" ADD CONSTRAINT "week_type_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_type_overrides" ADD CONSTRAINT "week_type_overrides_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_task_same_tenant_fk" FOREIGN KEY ("task_id","tenant_id") REFERENCES "public"."tasks"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_rollover_same_tenant_fk" FOREIGN KEY ("rolled_over_from_id","tenant_id") REFERENCES "public"."task_occurrences"("id","tenant_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_same_tenant_fk" FOREIGN KEY ("parent_id","tenant_id") REFERENCES "public"."tasks"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_category_same_tenant_fk" FOREIGN KEY ("category_id","tenant_id") REFERENCES "public"."categories"("id","tenant_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_same_tenant_fk" FOREIGN KEY ("sequence_id","tenant_id") REFERENCES "public"."sequences"("id","tenant_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_appointment_same_tenant_fk" FOREIGN KEY ("appointment_id","tenant_id") REFERENCES "public"."appointments"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_recurrence_parent_same_tenant_fk" FOREIGN KEY ("recurrence_parent_id","tenant_id") REFERENCES "public"."appointments"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_calendar_same_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_occurrence_same_tenant_fk" FOREIGN KEY ("occurrence_id","tenant_id") REFERENCES "public"."task_occurrences"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_occurrences_one_per_non_recurring_task" ON "task_occurrences" USING btree ("task_id") WHERE "task_occurrences"."period_start" is null;--> statement-breakpoint
CREATE INDEX "task_occurrences_status_idx" ON "task_occurrences" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_calendar_status_idx" ON "tasks" USING btree ("calendar_id","status");--> statement-breakpoint
CREATE INDEX "tasks_sequence_idx" ON "tasks" USING btree ("sequence_id");--> statement-breakpoint
CREATE INDEX "appointments_calendar_idx" ON "appointments" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX "appointments_recurrence_parent_idx" ON "appointments" USING btree ("recurrence_parent_id");--> statement-breakpoint
CREATE INDEX "commands_tenant_seq_idx" ON "commands" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "commands_group_idx" ON "commands" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "placements_calendar_idx" ON "placements" USING btree ("calendar_id");