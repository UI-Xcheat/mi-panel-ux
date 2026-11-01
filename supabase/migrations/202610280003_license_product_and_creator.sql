alter table public.licenses
  add column if not exists product text not null default 'No especificado',
  add column if not exists generated_by text not null default 'No registrado';
