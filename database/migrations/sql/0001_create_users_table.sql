-- liquibase formatted sql
-- changeset moritzschramm:1

create table if not exists users (
    id uuid not null default gen_random_uuid(),
    email varchar(512) not null,
    passwordhash varchar(128) not null,
    firstname varchar(256) not null,
    lastname varchar(256) not null,
    primary key (id),
    constraint id_email_unique unique (id, email)
)

-- rollback drop table users