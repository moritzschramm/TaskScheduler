-- liquibase formatted sql
-- changeset moritzschramm:1

create table if not exists users (
    id uuid not null default gen_random_uuid(),
    email varchar(200) not null,
    passwordhash varchar(100) not null,
    firstname varchar(200) not null,
    lastname varchar(200) not null,
    primary key (id)
)

-- rollback drop table users