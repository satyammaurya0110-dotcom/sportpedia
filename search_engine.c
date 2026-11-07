#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#define MAX_RECORDS 500
#define MAX_LEN 1024

typedef struct {
    int id;
    char title[256];
    char category[128];
    char snippet[MAX_LEN];
} Record;

Record records[MAX_RECORDS];
int record_count = 0;

void to_lower_str(char *str) {
    for (int i = 0; str[i]; i++) {
        str[i] = tolower((unsigned char)str[i]);
    }
}

void load_corpus() {
    FILE *file = fopen("sports_corpus.txt", "r");
    if (!file) {
        return;
    }

    char line[MAX_LEN];
    int current_id = 1;
    char current_title[256] = "";
    char current_category[128] = "Sports";
    char current_snippet[MAX_LEN] = "";

    while (fgets(line, sizeof(line), file)) {
        // Remove trailing newline
        line[strcspn(line, "\r\n")] = 0;

        if (strncmp(line, "[TITLE]", 7) == 0) {
            // If we already have a record building, save it before starting a new one
            if (strlen(current_title) > 0) {
                if (record_count < MAX_RECORDS) {
                    records[record_count].id = current_id++;
                    strcpy(records[record_count].title, current_title);
                    strcpy(records[record_count].category, current_category);
                    strcpy(records[record_count].snippet, current_snippet);
                    record_count++;
                }
            }
            strcpy(current_title, line + 8);
            current_snippet[0] = '\0';
            strcpy(current_category, "Sports");
        } 
        else if (strncmp(line, "[CATEGORY]", 10) == 0) {
            strcpy(current_category, line + 11);
        } 
        else if (strncmp(line, "[SNIPPET]", 9) == 0) {
            strcpy(current_snippet, line + 10);
        }
    }

    // Save the last record
    if (strlen(current_title) > 0 && record_count < MAX_RECORDS) {
        records[record_count].id = current_id++;
        strcpy(records[record_count].title, current_title);
        strcpy(records[record_count].category, current_category);
        strcpy(records[record_count].snippet, current_snippet);
        record_count++;
    }

    fclose(file);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("[]\n");
        return 0;
    }

    load_corpus();

    char query[256];
    strcpy(query, argv[1]);
    to_lower_str(query);

    printf("[\n");
    int first = 1;

    for (int i = 0; i < record_count; i++) {
        char t_lower[256], s_lower[MAX_LEN], c_lower[128];
        strcpy(t_lower, records[i].title);
        strcpy(s_lower, records[i].snippet);
        strcpy(c_lower, records[i].category);
        
        to_lower_str(t_lower);
        to_lower_str(s_lower);
        to_lower_str(c_lower);

        // Check if query matches title, snippet, or category
        if (strstr(t_lower, query) || strstr(s_lower, query) || strstr(c_lower, query)) {
            if (!first) {
                printf(",\n");
            }
            first = 0;
            printf("  {\n");
            printf("    \"id\": %d,\n", records[i].id);
            printf("    \"title\": \"%s\",\n", records[i].title);
            printf("    \"category\": \"%s\",\n", records[i].category);
            printf("    \"snippet\": \"%s\"\n", records[i].snippet);
            printf("  }");
        }
    }

    printf("\n]\n");
    return 0;
}