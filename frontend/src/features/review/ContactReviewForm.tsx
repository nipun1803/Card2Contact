import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Textarea } from "@/shared/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/shared/components/ui/form";
import { Label } from "@/shared/components/ui/label";
import { contactSchema, type ContactFormValues } from "@/shared/lib/schemas";
import type { Contact } from "@/shared/types/contact";

interface ContactReviewFormProps {
  contact: Contact;
  saving: boolean;
  error?: string | null;
  onConfirm: (contact: Contact) => void;
}

/** Map the API Contact (string[]) to the form shape ({value}[] for field arrays). */
function toForm(contact: Contact): ContactFormValues {
  return {
    name: contact.name,
    email: contact.email,
    company: contact.company,
    category: contact.category,
    note: contact.note,
    phones: contact.phones.length ? contact.phones.map((value) => ({ value })) : [{ value: "" }],
    addresses: contact.addresses.length ? contact.addresses.map((value) => ({ value })) : [],
  };
}

/** Map form values back to the API Contact, dropping empty array entries. */
function fromForm(values: ContactFormValues): Contact {
  return {
    name: values.name.trim(),
    email: values.email,
    company: values.company,
    category: values.category,
    note: values.note,
    phones: values.phones.map((p) => p.value.trim()).filter(Boolean),
    addresses: values.addresses.map((a) => a.value.trim()).filter(Boolean),
  };
}

/**
 * M4 review + edit. Only `name` is required (mirrors the backend). Phones and
 * addresses are dynamic lists; the full arrays are sent (the backend replaces
 * them wholesale on PATCH).
 */
export function ContactReviewForm({ contact, saving, error, onConfirm }: ContactReviewFormProps) {
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: toForm(contact),
    mode: "onSubmit",
  });

  const phones = useFieldArray({ control: form.control, name: "phones" });
  const addresses = useFieldArray({ control: form.control, name: "addresses" });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review the contact</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-6"
            onSubmit={form.handleSubmit((values) => onConfirm(fromForm(values)))}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="Full name" invalid={!!form.formState.errors.name} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="company"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company</FormLabel>
                    <FormControl>
                      <Input placeholder="Company" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" inputMode="email" placeholder="name@company.com" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {/* Phones */}
            <div className="space-y-2">
              <Label>Phone numbers</Label>
              <div className="space-y-2">
                {phones.fields.map((f, i) => (
                  <div key={f.id} className="flex items-center gap-2">
                    <Input
                      type="tel"
                      inputMode="tel"
                      placeholder="Phone number"
                      aria-label={`Phone number ${i + 1}`}
                      {...form.register(`phones.${i}.value` as const)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove phone number ${i + 1}`}
                      onClick={() => phones.remove(i)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => phones.append({ value: "" })}>
                <Plus aria-hidden />
                Add phone
              </Button>
            </div>

            {/* Addresses */}
            <div className="space-y-2">
              <Label>Addresses</Label>
              <div className="space-y-2">
                {addresses.fields.map((f, i) => (
                  <div key={f.id} className="flex items-start gap-2">
                    <Textarea
                      rows={2}
                      placeholder="Address"
                      aria-label={`Address ${i + 1}`}
                      {...form.register(`addresses.${i}.value` as const)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove address ${i + 1}`}
                      onClick={() => addresses.remove(i)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => addresses.append({ value: "" })}>
                <Plus aria-hidden />
                Add address
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Client, Vendor" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="Anything else worth remembering" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            {error && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" className="w-full" loading={saving}>
              {saving ? "Saving…" : "Save to Google Sheets"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
