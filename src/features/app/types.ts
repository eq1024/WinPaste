import type { Dispatch, SetStateAction } from "react";

export type StateSetter<T> = Dispatch<SetStateAction<T>>;

export type InstalledAppOption = { label: string; value: string };
export type DefaultAppsMap = Record<string, string>;
