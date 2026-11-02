#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#define MAX_LINE 1024

void to_lower_case(char *str) {
    for (int i = 0; str[i]; i++) {
        str[i] = tolower((unsigned char)str[i]);
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("[]\n");
        return 0;
    }

    char query[256];
    strncpy(query, argv[1], sizeof(query) - 1);
    query[sizeof(query) - 1] = '\0';
    to_lower_case(query);

    FILE *file = fopen("sports_corpus.txt", "r");
    if (!file) {
        printf("[\n  {\n    \"id\": -1,\n    \"title\": \"Corpus not found\",\n    \"category\": \"System\",\n    \"snippet\": \"Please ensure sports_corpus.txt is in the root project folder.\"\n  }\n]\n");
        return 0;
    }

    char line[MAX_LINE];
    int match_count = 0;

    printf("[\n");

    while (fgets(line, sizeof(line), file)) {
        line[strcspn(line, "\r\n")] = 0;
        if (strlen(line) == 0) continue;

        char *id_str = strtok(line, "|");
        char *title = strtok(NULL, "|");
        char *category = strtok(NULL, "|");
        char *content = strtok(NULL, "|");

        if (!id_str || !title || !category || !content) continue;

        char title_lower[256];
        char content_lower[1024];
        
        strcpy(title_lower, title);
        to_lower_case(title_lower);

        strcpy(content_lower, content);
        to_lower_case(content_lower);

        if (strstr(title_lower, query) != NULL || strstr(content_lower, query) != NULL) {
            if (match_count > 0) {
                printf(",\n");
            }
            
            printf("  {\n");
            printf("    \"id\": %s,\n", id_str);
            printf("    \"title\": \"%s\",\n", title);
            printf("    \"category\": \"%s\",\n", category);
            printf("    \"snippet\": \"%s\"\n", content);
            printf("  }");
            
            match_count++;
        }
    }

    fclose(file);

    if (match_count == 0) {
        printf("  {\n");
        printf("    \"id\": -1,\n");
        printf("    \"title\": \"No sports results found for '%s'\",\n", argv[1]);
        printf("    \"category\": \"General\",\n");
        printf("    \"snippet\": \"Try searching for 'Cricket', 'Messi', 'Novak', or 'Olympics'.\"\n");
        printf("  }\n");
    } else {
        printf("\n");
    }

    printf("]\n");

    return 0;
}

